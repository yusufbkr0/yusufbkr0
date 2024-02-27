with open(r"C:\Users\LENOVO\Desktop\python\newss\ornek_metin.txt","r") as file:
   with open("gecenler.txt","w") as gecti:
      with open("kalanlar.txt","w") as kalan:
        basliklar=["ad soyad","bolum","ortalamasi"]
        içerik=file.readlines()
        m=0
        for satir in içerik:
            if m==0:
               m+=1
               continue
            satir=satir.replace("\n","")
            bosluk_sayisi=0
            index=0
            bosluk_indexleri=[]
            for karakter in satir:
               if karakter==" ":
                  bosluk_sayisi+=1
                  bosluk_indexleri.append(index)
               index+=1
            #isim soy isim tanımlama
            ad_soyad=satir[:bosluk_indexleri[0]]
            soyad=ad_soyad.split("-")[-1]
            ad=ad_soyad[:ad_soyad.index(soyad)-1].replace("-"," ")
            #bolum tanimlama
            bolum=satir[bosluk_indexleri[0]:bosluk_indexleri[len(bosluk_indexleri)-1]] 
            #notlari hesaplama
            notlar=satir.split(" ")[-1]
            vize1=notlar.split("/")[0]
            vize2=notlar.split("/")[1]
            final=int(notlar.split("/")[-1])
            küsüratliort=(0.3*int(vize1)+0.3*int(vize2)+0.4*int(final))
            ortlama=round(küsüratliort)
            #yazdirma islemi
            
            if ortlama >= 50: 
                    #ad soyad yazdirma 
                    print(f"{ad} {soyad}",end=" ")
                    print(" "*(30-(len(ad_soyad))))
                    gecti.write(f"{ad} {soyad}")
                    gecti.write(" "*(30-(len(ad_soyad))))

                    #bolum yazdirma
                    print(f"{bolum}",end=" ")
                    print(" "*(30-(len(bolum))),end=" ")
                    gecti.write(f"{bolum}")
                    gecti.write(" "*(30-(len(bolum))))

                    #ortalama yazdirma
                    
                    print(f"{ortlama}\n")
                  
                    gecti.write(f"{ortlama}\n")
                  
            else:
                       #ad soyad yazdirma 
                    print(f"{ad} {soyad}",end=" ")
                    print(" "*(30-(len(ad_soyad))))
                    kalan.write(f"{ad} {soyad}")
                    kalan.write(" "*(30-(len(ad_soyad))))

                    #bolum yazdirma
                    print(f"{bolum} ")
                    print(" "*(30-(len(bolum))))
                    kalan.write(f"{bolum}")
                    kalan.write(" "*(30-(len(bolum))))

                    #ortalama yazdirma
                    
                    print(f"{ortlama}\n")

                    kalan.write(f"{ortlama}\n")


#thank you
                
          
           

           


        
